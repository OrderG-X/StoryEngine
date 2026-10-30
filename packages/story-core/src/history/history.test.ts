// 写作版本 P2a 片 4B：撤销一次操作（链、影响、前像、引用核对、守护线）、整本恢复（范围摘要）、history.apply。设计 8.1 / 8.2 / 十一。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCommand } from "../commands/runner.js";
import type { WriteCommandSpec } from "../commands/types.js";
import { emptySettingCards } from "../schema/cards.js";
import { AuthorDecision } from "../schema/decisions.js";
import { CHAPTER_LEDGER_SCHEMA, LedgerEntry } from "../schema/ledger.js";
import { opBookEpoch, readBookEpoch, readDraftGens } from "../store/control.js";
import { CARDS_PATH, chapterLedgerPath, chapterTextPath, DECISIONS_PATH, draftPath } from "../store/paths.js";
import { sha256Bytes } from "../store/transaction.js";
import { historyApply } from "./apply.js";
import { refsOfDecision, refsOfEntry, Resolver } from "./references.js";
import { planRestore } from "./restore.js";
import { BOOK_START_KEYS, lastUndoable, planRevert, readReceipts, type RevertPlan } from "./revert.js";
import { readUndoableFiles, type HistoryReader } from "./store.js";

let book: string;
let clock: number;
let step: number;
let git: FakeGit;

/** 测试用的存档：每次打存档把撤销范围里的文件抄一份，树号是序号。 */
class FakeGit implements HistoryReader {
  readonly trees = new Map<string, Map<string, string>>();
  readonly blobs = new Map<string, Uint8Array>();
  keyOf(bytes: Uint8Array): string {
    return sha256Bytes(bytes);
  }
  async list(tree: string): Promise<ReadonlyMap<string, string> | undefined> {
    return this.trees.get(tree);
  }
  async read(key: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(key);
    if (!bytes) throw new Error("gone");
    return bytes;
  }
  async capture(): Promise<string> {
    const map = new Map<string, string>();
    for (const [path, bytes] of await readUndoableFiles(book)) {
      const key = this.keyOf(bytes);
      this.blobs.set(key, bytes);
      map.set(path, key);
    }
    const id = `tree-${this.trees.size + 1}`;
    this.trees.set(id, map);
    return id;
  }
}

beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-history-"));
  clock = Date.parse("2026-10-30T00:00:00.000Z");
  step = 0;
  git = new FakeGit();
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const now = (): Date => new Date((clock += 1000));
const options = (opId: string) => ({ caller: "author" as const, op: { opId, stepId: `s${(step += 1)}` }, snapshot: () => git.capture(), now });

/** 照原样写几份文件（null = 删），代替各种真命令：每个场景要的字节都摆得准。 */
const rawWrite: WriteCommandSpec<{ files: { path: string; content: string | null }[] }, null> = {
  name: "test.write",
  tier: "ai-direct",
  summary: "测试写",
  args: z.object({ files: z.array(z.object({ path: z.string(), content: z.string().nullable() })) }),
  snapshot: true,
  idempotent: true,
  async plan(_context, args) {
    return { label: "写", writes: args.files.map((file) => (file.content === null ? { path: file.path, delete: true as const } : { path: file.path, content: file.content })), changed: {}, result: null };
  },
};

async function write(opId: string, files: { path: string; content: string | null }[]): Promise<void> {
  const outcome = await runCommand(book, rawWrite, { files }, options(opId));
  expect(outcome.ok).toBe(true);
}

const TEXT = (chapter: number, extra = ""): string => `# 第${chapter}章\n\n正文${chapter}${extra}`;
const quote = (chapter: number): string => `正文${chapter}`;
const open = (chapter: number, n: number, title: string) => ({ id: `c${chapter}-${n}`, kind: "thread", review: "auto", op: "open", type: "question", title, note: title, quote: quote(chapter), thread: `t${chapter}-${n}` });
const advance = (chapter: number, n: number, thread: string, note = "追下去") => ({ id: `c${chapter}-${n}`, kind: "thread", review: "auto", op: "advance", note, quote: quote(chapter), thread });
const factOf = (chapter: number, n: number, subject: string, value: string) => ({ id: `c${chapter}-${n}`, kind: "fact", review: "auto", nature: "state", subject, attribute: "伤势", value, text: `${subject}${value}`, quote: quote(chapter) });
const timeOf = (chapter: number, n: number, time: Record<string, unknown>) => ({ id: `c${chapter}-${n}`, kind: "time", review: "auto", ...time });

function ledgerText(chapter: number, entries: unknown[], options: { readonly stamp?: string; readonly text?: string } = {}): string {
  const ledger = { schema: CHAPTER_LEDGER_SCHEMA, chapter, textSha256: sha256Bytes(options.text ?? TEXT(chapter)), committedAt: options.stamp ?? `stamp-${chapter}`, origin: "commit", entries };
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/** 一章的正文 + 账单。 */
const chapter = (n: number, entries: unknown[], options: { readonly stamp?: string; readonly text?: string } = {}) => [
  { path: chapterTextPath(n), content: options.text ?? TEXT(n) },
  { path: chapterLedgerPath(n), content: ledgerText(n, entries, options) },
];

async function revert(opId: string): Promise<RevertPlan> {
  const plan = await planRevert(book, { opId }, git);
  if (!plan.ok) throw new Error(`没算成：${plan.code} ${plan.message}`);
  return plan;
}

async function applyRevert(opId: string, plan: RevertPlan, by = `undo-${opId}`) {
  return runCommand(book, historyApply, { kind: "revert", label: "撤销", target: { opId }, changes: plan.changes.map((change) => ({ ...change })) }, options(by));
}

const read = (path: string) => readFile(join(book, path), "utf-8");
const exists = (path: string) => read(path).then(() => true, () => false);

describe("撤销一次操作：基本", () => {
  it("撤掉首次定稿：正文和账删掉（回执记写后 = 不存在），换写入代次和工作稿纪元，不换书的纪元", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    const epochBefore = await readBookEpoch(book);
    const gensBefore = await readDraftGens(book);
    const plan = await revert("A");
    expect(plan.impact).toEqual([]);
    expect(plan.changes.map((change) => [change.path, change.content])).toEqual([[chapterTextPath(1), null], [chapterLedgerPath(1), null]]);
    const done = await applyRevert("A", plan);
    expect(done).toMatchObject({ ok: true, changed: { chapters: [1], ledgers: [1] } });
    expect(await exists(chapterTextPath(1))).toBe(false);
    expect(await exists(chapterLedgerPath(1))).toBe(false);
    expect(await readBookEpoch(book)).toBe(epochBefore);
    expect((await readDraftGens(book)).epoch).not.toBe(gensBefore.epoch);
    const undo = (await readReceipts(book)).find((receipt) => receipt.command === "history.apply");
    expect(undo?.effects?.every((effect) => effect.after === null)).toBe(true);
    expect(undo?.snapshotTree).toBeTruthy();
  });

  it("A 开线索、B 在后一章推进它：撤 A 被拒、说第 2 章接着；先撤 B 再撤 A 成", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("B", chapter(2, [advance(2, 1, "t1-1")]));
    const blocked = await planRevert(book, { opId: "A" }, git);
    expect(blocked).toMatchObject({ ok: false, code: "referenced" });
    expect(!blocked.ok && blocked.message).toContain("第 2 章的账");
    expect(!blocked.ok && blocked.message).not.toMatch(/t1-1|c2-1/u);
    expect(await applyRevert("B", await revert("B"))).toMatchObject({ ok: true });
    expect(await applyRevert("A", await revert("A"))).toMatchObject({ ok: true });
  });

  it("后来被别的操作改过：列出影响（谁改的）；不走回执改的标说不清", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("C", chapter(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "左臂伤")], { stamp: "stamp-1b" }));
    const plan = await revert("A");
    // 正文 C 照原样写了一遍（字节没变）：不算后来改过。
    expect(plan.impact.map((item) => [item.path, item.by.map((by) => by.opId), item.unknown])).toEqual([[chapterLedgerPath(1), ["C"], false]]);
    await writeFile(join(book, chapterTextPath(1)), "作者在别处改的");
    const again = await revert("A");
    expect(again.impact.find((item) => item.path === chapterTextPath(1))?.unknown).toBe(true);
    expect(again.impactDigest).not.toBe(plan.impactDigest);
  });

  it("这次操作之前就在、没被换掉的引用者不解析（短路）", async () => {
    await write("P", [...chapter(1, [open(1, 1, "铜钥匙")]), ...chapter(2, [advance(2, 1, "t1-1")])]);
    await write("A", chapter(3, [advance(3, 1, "t1-1", "又一层")]));
    const spy = vi.spyOn(Resolver.prototype, "identities");
    await revert("A");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("升级之前的回执（没 effects）：只能整本恢复；存档树裁掉了：撤不了", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    const [receipt] = await readReceipts(book);
    await mkdir(join(book, "ledger/receipts"), { recursive: true });
    const legacy = { ...receipt, key: "legacy-key", opId: "OLD" } as Record<string, unknown>;
    delete legacy.effects;
    await writeFile(join(book, "ledger/receipts/legacy.json"), JSON.stringify(legacy));
    expect(await planRevert(book, { opId: "OLD" }, git)).toMatchObject({ ok: false, code: "legacy_receipt" });
    git.trees.clear();
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "tree_gone" });
  });

  it("撤销一笔撤销：真相回到第一次撤销之前", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    const original = await read(chapterLedgerPath(1));
    expect(await applyRevert("A", await revert("A"), "U1")).toMatchObject({ ok: true });
    expect(await exists(chapterLedgerPath(1))).toBe(false);
    expect(await applyRevert("U1", await revert("U1"), "U2")).toMatchObject({ ok: true });
    expect(await read(chapterLedgerPath(1))).toBe(original);
  });

  it("算好之后这一份又改过：一处都不动、如实说", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    const plan = await revert("A");
    await writeFile(join(book, chapterTextPath(1)), "后来改的");
    expect(await applyRevert("A", plan)).toMatchObject({ ok: false, code: "changed_since_plan" });
    expect(await exists(chapterLedgerPath(1))).toBe(true);
  });

  it("带范围摘要：算好之后别处多了一章（可能接着要撤的）也不写、如实说", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    const plan = await revert("A");
    await writeFile(join(book, chapterTextPath(2)), TEXT(2));
    const args = { kind: "revert" as const, label: "撤销", target: { opId: "A" }, changes: plan.changes.map((change) => ({ ...change })), rangeDigest: plan.rangeDigest };
    expect(await runCommand(book, historyApply, args, options("U1"))).toMatchObject({ ok: false, code: "range_changed" });
    expect(await exists(chapterLedgerPath(1))).toBe(true);
  });
});

describe("撤销核引用：基准按引用者自己接着的那一刻", () => {
  it("配套回退照撤：一次操作先改开线索那章、再改推进那章；中间作者改了第 2 章章名（只动正文和正文哈希栏）", async () => {
    await write("P", [...chapter(1, [open(1, 1, "铜钥匙")]), ...chapter(2, [advance(2, 1, "t1-1")])]);
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铁钥匙")]) }]);
    const retitled = TEXT(2, "（改了章名）");
    await write("R", [{ path: chapterTextPath(2), content: retitled }, { path: chapterLedgerPath(2), content: ledgerText(2, [advance(2, 1, "t1-1")], { text: retitled }) }]);
    await write("A", [{ path: chapterLedgerPath(2), content: ledgerText(2, [advance(2, 1, "t1-1", "追铁钥匙")], { text: retitled }) }]);
    const plan = await revert("A");
    expect(plan.impact).toEqual([]);
    expect(await applyRevert("A", plan)).toMatchObject({ ok: true });
    expect(await read(chapterLedgerPath(1))).toContain("铜钥匙");
    expect(await read(chapterLedgerPath(2))).not.toContain("追铁钥匙");
  });

  it("第 6 轮反例：A 改第 1 章（铜 → 铁）→ B 写第 2 章推进 → A 重记第 2 章 → 撤 A 被拒", async () => {
    await write("P", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铁钥匙")]) }]);
    await write("B", chapter(2, [advance(2, 1, "t1-1", "追铁钥匙")]));
    await write("A", [{ path: chapterLedgerPath(2), content: ledgerText(2, [advance(2, 1, "t1-1", "改写")]) }]);
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
  });

  it("第 7 轮反例：A 改铁、B 推进、A 改回铜、A 再改第 2 章 → 撤 A 被拒（基准不拿这次操作的中间态）", async () => {
    await write("P", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铁钥匙")]) }]);
    await write("B", chapter(2, [advance(2, 1, "t1-1", "追铁钥匙")]));
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铜钥匙")], { stamp: "stamp-1c" }) }]);
    await write("A", [{ path: chapterLedgerPath(2), content: ledgerText(2, [advance(2, 1, "t1-1", "追铜钥匙")]) }]);
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
  });

  it("区间写入证据（Astra 第 10 轮第 2 条）：窗口里别人改走又改回、两头一样也证明不了 → 拦；窗口里没人写过 → 照撤", async () => {
    const x0 = ledgerText(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "左臂伤")]);
    const x1 = ledgerText(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "右臂伤")]);
    await write("P", [{ path: chapterTextPath(1), content: TEXT(1) }, { path: chapterLedgerPath(1), content: x0 }]);
    await write("A", [{ path: chapterLedgerPath(1), content: x1 }]);
    await write("B", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "银钥匙")], { stamp: "stamp-1y" }) }]);
    await write("B", chapter(2, [advance(2, 1, "t1-1", "追银钥匙")]));
    await write("B", [{ path: chapterLedgerPath(1), content: x1 }]);
    await write("A", [{ path: chapterLedgerPath(2), content: ledgerText(2, [advance(2, 1, "t1-1", "改写")]) }]);
    const blocked = await planRevert(book, { opId: "A" }, git);
    expect(blocked).toMatchObject({ ok: false, code: "unprovable" });
    expect(!blocked.ok && blocked.message).toContain("第 2 章的账");
  });

  it("窗口里没人写过开线索那章：两头一样，照撤", async () => {
    const x0 = ledgerText(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "左臂伤")]);
    const x1 = ledgerText(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "右臂伤")]);
    await write("P", [{ path: chapterTextPath(1), content: TEXT(1) }, { path: chapterLedgerPath(1), content: x0 }]);
    await write("A", [{ path: chapterLedgerPath(1), content: x1 }]);
    await write("B", chapter(2, [advance(2, 1, "t1-1", "追铜钥匙")]));
    await write("A", [{ path: chapterLedgerPath(2), content: ledgerText(2, [advance(2, 1, "t1-1", "改写")]) }]);
    expect(await applyRevert("A", await revert("A"))).toMatchObject({ ok: true });
  });

  it("相对时间：第 3 章「当天」接着第 2 章 → 撤掉第 2 章被拒；撤掉一条天数裁定不拦", async () => {
    await write("P", chapter(1, [timeOf(1, 1, { basis: "author", day: 1 })]));
    await write("A", chapter(2, [timeOf(2, 1, { basis: "author", day: 10 })]));
    await write("C", chapter(3, [timeOf(3, 1, { basis: "text", quote: quote(3), daysSincePrevious: 0 })]));
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
    const decisions = { schema: "author-decisions/1", decisions: [{ id: "d-1", at: "x", type: "chapter.day", chapter: 1, day: 2 }] };
    await write("D", [{ path: DECISIONS_PATH, content: JSON.stringify(decisions) }]);
    expect(await applyRevert("D", await revert("D"))).toMatchObject({ ok: true });
  });

  it("名字解析链：撤掉立别名「阿青 → 林青」的那张卡，后章事实的主体会变 → 拒", async () => {
    const card = { id: "k-1", kind: "character" as const, name: "林青", aliases: ["阿青"], fields: [], by: "author" as const, at: "x" };
    await write("A", [{ path: CARDS_PATH, content: JSON.stringify({ ...emptySettingCards(), cards: [card] }) }]);
    await write("B", chapter(2, [factOf(2, 1, "阿青", "左臂伤")]));
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
  });

  it("名字按本名认也核是哪个人：A 删卡重建同名的另一张卡、B 后来写这个名字 → 撤 A 拒（Astra 第 11 轮第 1 条）；A 之前就写了这个名字的照撤", async () => {
    const cards = (id: string) => [{
      path: CARDS_PATH,
      content: JSON.stringify({ ...emptySettingCards(), cards: [{ id, kind: "character", name: "林远", aliases: [], fields: [], by: "author", at: "x" }] }),
    }];
    await write("P", [...cards("k-1"), ...chapter(1, [factOf(1, 1, "林远", "左臂伤")])]);
    await write("A", cards("k-3"));
    // 只有 A 之前写的那条：撤 A 回到它写下时那张卡，照撤。
    expect((await planRevert(book, { opId: "A" }, git)).ok).toBe(true);
    await write("B", chapter(2, [factOf(2, 1, "林远", "手上有伤")]));
    const blocked = await planRevert(book, { opId: "A" }, git);
    expect(blocked).toMatchObject({ ok: false, code: "referenced" });
    expect(!blocked.ok && blocked.message).toContain("第 2 章的账");
  });

  it("撤掉开事实的那次、后面有作者裁定撤回这条事实 → 拒；裁定接着那一章（梗概）→ 拒", async () => {
    await write("A", chapter(1, [factOf(1, 1, "林青", "左臂伤")]));
    const decisions = (list: unknown[]) => [{ path: DECISIONS_PATH, content: JSON.stringify({ schema: "author-decisions/1", decisions: list }) }];
    await write("D", decisions([{ id: "d-1", at: "x", type: "fact.retract", fact: "c1-1" }]));
    const blocked = await planRevert(book, { opId: "A" }, git);
    expect(blocked).toMatchObject({ ok: false, code: "referenced" });
    expect(!blocked.ok && blocked.message).toContain("你记的裁定");
    await write("D2", decisions([{ id: "d-2", at: "x", type: "chapter.summary", chapter: 1, text: "作者改的梗概" }]));
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
  });

  it("设定变化：A 之前作者改别名 → 撤成；A 之后才改、旧内容的名字解析变了 → 拒；A 自己配套改卡 → 撤成", async () => {
    const cards = (aliases: string[]) => [{ path: CARDS_PATH, content: JSON.stringify({ ...emptySettingCards(), cards: [{ id: "k-1", kind: "character", name: "林青", aliases, fields: [], by: "author", at: "x" }] }) }];
    await write("P", chapter(1, [factOf(1, 1, "阿青", "左臂伤")]));
    await write("K", cards(["阿青"]));
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [factOf(1, 1, "阿青", "右臂伤")]) }]);
    expect((await planRevert(book, { opId: "A" }, git)).ok).toBe(true);
    await write("K2", cards([]));
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
    await write("B", [...cards(["阿青", "青儿"]), { path: chapterLedgerPath(1), content: ledgerText(1, [factOf(1, 1, "青儿", "右臂伤")]) }]);
    expect(await applyRevert("B", await revert("B"))).toMatchObject({ ok: true });
  });

  it("这次操作之后写的引用者按现在核：后来新写的一章接着被撤的那条 → 拒", async () => {
    await write("P", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铁钥匙")]) }]);
    await write("B", chapter(2, [advance(2, 1, "t1-1", "追铁钥匙")]));
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "referenced" });
  });

  it("守护线：撤完这章正文和账对不上（撤之前对得上）就不撤", async () => {
    await write("P", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("A", [{ path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "左臂伤")]) }]);
    const retitled = TEXT(1, "（改了章名）");
    await write("R", [{ path: chapterTextPath(1), content: retitled }, { path: chapterLedgerPath(1), content: ledgerText(1, [open(1, 1, "铜钥匙"), factOf(1, 2, "林青", "左臂伤")], { text: retitled }) }]);
    expect(await planRevert(book, { opId: "A" }, git)).toMatchObject({ ok: false, code: "guard_mismatch" });
  });
});

describe("压测", () => {
  it("200 章的书撤一次 200 章的通读：中间作者在 5 个时刻写过裁定、第 150 章的账作者改过（确认全撤）", async () => {
    const entries = (n: number) => [open(n, 1, `第${n}章的事`), ...(n > 1 ? [advance(n, 2, `t${n - 1}-1`)] : []), factOf(n, 3, "林青", `第${n}章的伤`), { id: `c${n}-4`, kind: "presence", review: "auto", name: "林青", nameUsed: n % 2 ? "阿青" : "林青", quote: quote(n) }];
    const files = Array.from({ length: 200 }, (_, index) => chapter(index + 1, [])).flat();
    await write("IMPORT", files);
    const decisions: unknown[] = [];
    for (let n = 1; n <= 200; n += 1) {
      await write("READ", [{ path: chapterLedgerPath(n), content: ledgerText(n, entries(n), { stamp: `reread-${n}` }) }]);
      if (n % 40 === 20) {
        decisions.push({ id: `d-${n}`, at: "x", type: "thread.weight", thread: "t1-1", weight: "major" });
        await write(`D${n}`, [{ path: DECISIONS_PATH, content: JSON.stringify({ schema: "author-decisions/1", decisions }) }]);
      }
      if (n === 160) await write("EDIT", [{ path: chapterLedgerPath(150), content: ledgerText(150, entries(150).slice(0, 2), { stamp: "author-edit" }) }]);
    }
    const started = performance.now();
    const heap = process.memoryUsage().heapUsed;
    const plan = await planRevert(book, { opId: "READ" }, git);
    const ms = performance.now() - started;
    console.info(`[压测] 200 章撤通读：${Math.round(ms)} ms，堆增 ${Math.round((process.memoryUsage().heapUsed - heap) / 1e6)} MB`);
    // 作者在通读中途写的裁定接着第 1 章开的线索，撤了通读那条线索就没了 → 拒。
    expect(plan).toMatchObject({ ok: false, code: "referenced" });
    expect(!plan.ok && plan.message).toContain("你记的裁定");
    expect(ms).toBeLessThan(20_000);
  }, 120_000);
});

describe("「撤销上一步」撤哪次", () => {
  it("最近一次写过的；撤销本身、被撤过的跳过；撤销被撤了又算；真换了东西的整本恢复就是上一次，恢复被撤了接着往前", async () => {
    await write("A", chapter(1, [open(1, 1, "铜钥匙")]));
    await write("B", chapter(2, []));
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "B" });
    expect(await applyRevert("B", await revert("B"), "U1")).toMatchObject({ ok: true });
    // 撤过 B：下一次是 A（撤销 U1 本身跳过）。
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "A" });
    // 撤回来（撤 U1）：B 又算没被撤，上一次是 B。
    const redo = await planRevert(book, { opId: "U1" }, git);
    if (!redo.ok) throw new Error(redo.message);
    expect(await runCommand(book, historyApply, { kind: "revert", label: "撤销", target: { opId: "U1" }, changes: redo.changes.map((change) => ({ ...change })) }, options("U2"))).toMatchObject({ ok: true });
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "B" });
    // 整本恢复（换了东西）就是上一次：撤它 = 回到恢复之前；恢复被撤了，接着往前算（又是 C）。
    const tree = await git.capture();
    await write("C", chapter(3, []));
    const plan = await planRestore(book, tree, git);
    if (!plan.ok) throw new Error(plan.message);
    expect(await runCommand(book, historyApply, { kind: "restore", label: "恢复", target: { tree }, changes: plan.changes.map((change) => ({ ...change })), rangeDigest: plan.rangeDigest }, options("R"))).toMatchObject({ ok: true });
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "R" });
    expect(await applyRevert("R", await revert("R"), "U3")).toMatchObject({ ok: true });
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "C" });
  });

  it("撤 A 时「全撤」顺带整个退掉的 B 不再算「上一次」；撤回来之后 B 又算（Astra 第 11 轮第 3 条）", async () => {
    await write("P", chapter(3, []));
    await write("A", chapter(1, []));
    await write("B", chapter(1, [], { text: TEXT(1, "，第二版"), stamp: "stamp-1b" }));
    const plan = await revert("A");
    expect(plan.impact.map((item) => [item.path, item.by.map((by) => by.opId)])).toEqual([[chapterTextPath(1), ["B"]], [chapterLedgerPath(1), ["B"]]]);
    expect(await applyRevert("A", plan, "U1")).toMatchObject({ ok: true });
    // B 改的只有第 1 章，撤 A 把它换回 A 写之前：B 已经不在了，上一次是 P。
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "P" });
    // 撤回来（撤 U1）：A、B 都回来了，上一次是 B。
    const redo = await planRevert(book, { opId: "U1" }, git);
    if (!redo.ok) throw new Error(redo.message);
    expect(await runCommand(book, historyApply, { kind: "revert", label: "撤销", target: { opId: "U1" }, changes: redo.changes.map((change) => ({ ...change })) }, options("U2"))).toMatchObject({ ok: true });
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "B" });
  });

  it("后来那次只被「全撤」退了一部分：照常算「上一次」", async () => {
    await write("A", chapter(1, []));
    await write("B", [...chapter(1, [], { text: TEXT(1, "，第二版"), stamp: "stamp-1b" }), ...chapter(2, [])]);
    expect(await applyRevert("A", await revert("A"), "U1")).toMatchObject({ ok: true });
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "B" });
  });

  it("建书、导入那几笔是起点：到它就停；升级之前、没留存档的写照样算一次（撤的时候如实说只能整本恢复）", async () => {
    const outcome = await runCommand(book, rawWrite, { files: chapter(1, []) }, { caller: "author", idempotencyKey: BOOK_START_KEYS.create, now });
    expect(outcome.ok).toBe(true);
    expect(lastUndoable(await readReceipts(book))).toBeUndefined();
    const untracked = await runCommand(book, rawWrite, { files: chapter(2, []) }, { caller: "author", idempotencyKey: "old-write", now });
    expect(untracked.ok).toBe(true);
    expect(lastUndoable(await readReceipts(book))).toEqual({ receiptKey: "old-write" });
    expect(await planRevert(book, { receiptKey: "old-write" }, git)).toMatchObject({ ok: false, code: "no_tree" });
    await write("A", chapter(3, []));
    expect(lastUndoable(await readReceipts(book))).toEqual({ opId: "A" });
  });
});

describe("整本恢复", () => {
  it("按树算写 / 删；冻结整个范围的摘要，计划后改过就不恢复；恢复换书的纪元", async () => {
    await write("P", [...chapter(1, [open(1, 1, "铜钥匙")]), { path: draftPath(2), content: "第二章稿" }]);
    const tree = await git.capture();
    await write("A", [...chapter(1, [open(1, 1, "铁钥匙")], { stamp: "later" }), ...chapter(3, [])]);
    const plan = await planRestore(book, tree, git);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.changes.map((change) => [change.path, change.content === null])).toEqual([
      [chapterTextPath(3), true],
      [chapterLedgerPath(1), false],
      [chapterLedgerPath(3), true],
    ]);
    const args = { kind: "restore" as const, label: "恢复", target: { tree }, changes: plan.changes.map((change) => ({ ...change })), rangeDigest: plan.rangeDigest };
    await writeFile(join(book, draftPath(2)), "计划之后作者又写了");
    expect(await runCommand(book, historyApply, args, options("R1"))).toMatchObject({ ok: false, code: "range_changed" });
    await writeFile(join(book, draftPath(2)), "第二章稿");
    const epoch = await readBookEpoch(book);
    expect(await runCommand(book, historyApply, args, options("R2"))).toMatchObject({ ok: true });
    expect(await read(chapterLedgerPath(1))).toContain("铜钥匙");
    expect(await exists(chapterTextPath(3))).toBe(false);
    expect(await readBookEpoch(book)).not.toBe(epoch);
    // 在操作里换的纪元由操作号定：那次操作认得出是自己换的。
    expect(await readBookEpoch(book)).toBe(opBookEpoch("R2"));
  });

  it("存档树裁掉了：如实说", async () => {
    expect(await planRestore(book, "tree-404", git)).toMatchObject({ ok: false, code: "tree_gone" });
  });
});

describe("引用表按 schema 穷举", () => {
  const entries: Record<string, unknown[]> = {
    summary: [{ id: "e", kind: "summary", review: "auto", text: "梗概", quote: "q" }],
    fact: [factOf(2, 1, "林青", "伤"), { ...factOf(2, 2, "林青", "伤"), replaces: ["c1-1"] }],
    thread: [open(2, 1, "题"), advance(2, 2, "t1-1"), { ...advance(2, 3, "t1-1"), op: "close" }],
    time: [timeOf(2, 1, { basis: "author", day: 3 }), timeOf(2, 2, { basis: "text", quote: "q", daysSincePrevious: 1 })],
    presence: [{ id: "e", kind: "presence", review: "auto", name: "林青", nameUsed: "阿青", quote: "q" }],
  };
  const expected: Record<string, string[][]> = {
    summary: [[]],
    fact: [["name"], ["fact", "name"]],
    thread: [[], ["thread"], ["thread"]],
    time: [[], ["previous"]],
    presence: [["name"]],
  };
  const decisions: Record<string, unknown> = {
    "thread.merge": { type: "thread.merge", from: ["t1"], into: "t2" },
    "thread.close": { type: "thread.close", thread: "t1", chapter: 3 },
    "thread.weight": { type: "thread.weight", thread: "t1", weight: "major" },
    "issue.dismiss": { type: "issue.dismiss", issue: "hard-fact:c1-1:c2-1" },
    "fact.retract": { type: "fact.retract", fact: "c1-1" },
    "fact.expire": { type: "fact.expire", fact: "c1-1", chapter: 3 },
    "fact.assert": { type: "fact.assert", chapter: 3, nature: "state", subject: "林青", attribute: "伤", value: "好了", text: "好了", corrects: "c1-1" },
    "chapter.day": { type: "chapter.day", chapter: 3, day: 4 },
    "chapter.summary": { type: "chapter.summary", chapter: 3, text: "梗概" },
  };
  const decisionKinds: Record<string, string[]> = {
    "thread.merge": ["thread", "thread"],
    "thread.close": ["thread", "chapter"],
    "thread.weight": ["thread"],
    "issue.dismiss": ["issue"],
    "fact.retract": ["fact"],
    "fact.expire": ["fact", "chapter"],
    "fact.assert": ["fact", "chapter", "name"],
    "chapter.day": ["chapter"],
    "chapter.summary": ["chapter"],
  };

  it("账单每种条目都有样例、出该出的引用（含时间的相对 / 绝对两种）", () => {
    const kinds = LedgerEntry.options.map((option) => option.shape.kind.value);
    expect(Object.keys(entries).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const got = (entries[kind] ?? []).map((sample) => refsOfEntry(LedgerEntry.parse(sample), 2).map((ref) => ref.kind));
      expect(got).toEqual(expected[kind]);
    }
  });

  it("裁定每种类型都有样例、出该出的引用；issue.dismiss 按自家格式解析成两条事实", () => {
    const types = AuthorDecision.options.map((option) => option.shape.type.value);
    expect(Object.keys(decisions).sort()).toEqual([...types].sort());
    for (const type of types) {
      const decision = AuthorDecision.parse({ id: "d-1", at: "x", ...(decisions[type] as object) });
      expect(refsOfDecision(decision).map((ref) => ref.kind)).toEqual(decisionKinds[type]);
    }
    const resolver = new Resolver({ ledgers: [], decisions: [], cards: undefined });
    expect(resolver.resolve({ kind: "issue", issue: "hard-fact:c1-1:c2-1" })).toBe("issue:hard-fact:c1-1:c2-1=fact:c1-1=none&fact:c2-1=none");
  });
});
